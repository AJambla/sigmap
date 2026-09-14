// Java fixture
package com.example;

public class UserService {
    private final UserRepository repo;

    public UserService(UserRepository repo) {
        this.repo = repo;
    }

    public User getUser(String id) {
        return repo.findById(id);
    }

    public User createUser(CreateUserDto dto) {
        return repo.save(new User(dto));
    }

    protected void validateUser(User user) {
        if (user == null) throw new IllegalArgumentException();
    }
}

public interface Repository<T, ID> {
    T findById(ID id);
    T save(T entity);
    void delete(ID id);
}

public record Point(int x, int y) {
    public double dist(Point o) {
        return 0.0;
    }
}

public sealed class Shape permits Circle {
    public String url() {
        String base = "https://example.com"; // inline note
        return base;
    }
}

public class Validators {
    public static <T extends Comparable<T>> T max(List<T> xs) {
        return xs.get(0);
    }

    public void check(@Size(max = 10) String name, Map<String, List<String>> index) {
    }
}
